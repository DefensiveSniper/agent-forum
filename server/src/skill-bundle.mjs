import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.css',
  '.html',
  '.svg',
]);

/**
 * 判断文件或目录名是否应被包含在 Skill Bundle 中。
 * 隐藏文件（如 .DS_Store）默认忽略，避免污染分发包。
 * @param {string} name
 * @returns {boolean}
 */
function shouldIncludeEntry(name) {
  return !!name && !name.startsWith('.');
}

/**
 * 将绝对路径转换为稳定的 POSIX 相对路径。
 * @param {string} baseDir
 * @param {string} targetPath
 * @returns {string}
 */
function toBundlePath(baseDir, targetPath) {
  return path.relative(baseDir, targetPath).split(path.sep).join('/');
}

/**
 * 判断文件内容应以 UTF-8 文本还是 Base64 形式返回。
 * @param {string} filePath
 * @param {Buffer} content
 * @returns {'utf8'|'base64'}
 */
function detectEncoding(filePath, content) {
  if (content.includes(0)) return 'base64';
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? 'utf8' : 'base64';
}

/**
 * 递归收集 Skill 目录下可分发的文件列表。
 * @param {string} dirPath
 * @returns {string[]}
 */
function collectFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!shouldIncludeEntry(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * 构建单个文件的 Bundle 元数据与内容。
 * @param {string} skillDir
 * @param {string} filePath
 * @returns {object}
 */
function buildBundleFile(skillDir, filePath) {
  const content = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  const encoding = detectEncoding(filePath, content);

  return {
    path: toBundlePath(skillDir, filePath),
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    encoding,
    content: encoding === 'utf8' ? content.toString('utf-8') : content.toString('base64'),
  };
}

/**
 * 计算整个 Skill Bundle 的稳定哈希。
 * @param {Array<object>} files
 * @returns {string}
 */
function calculateBundleSha(files) {
  const hash = crypto.createHash('sha256');

  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }

  return hash.digest('hex');
}

/**
 * 根据文件路径分类，方便客户端恢复目录结构或按用途消费。
 * @param {Array<object>} files
 * @returns {object}
 */
function buildManifest(files) {
  return {
    entrypoint: files.some((file) => file.path === 'SKILL.md') ? 'SKILL.md' : null,
    agents: files.filter((file) => file.path.startsWith('agents/')).map((file) => file.path),
    references: files.filter((file) => file.path.startsWith('references/')).map((file) => file.path),
    scripts: files.filter((file) => file.path.startsWith('scripts/')).map((file) => file.path),
    other: files
      .filter((file) => !['SKILL.md'].includes(file.path))
      .filter((file) => !file.path.startsWith('agents/'))
      .filter((file) => !file.path.startsWith('references/'))
      .filter((file) => !file.path.startsWith('scripts/'))
      .map((file) => file.path),
  };
}

/**
 * 读取指定 Skill 目录并生成完整 Bundle。
 * @param {object} options
 * @param {string} options.skillsRoot
 * @param {string} options.skillId
 * @returns {object|null}
 */
export function createSkillBundle({ skillsRoot, skillId }) {
  if (!/^[a-z0-9-]+$/.test(skillId)) return null;

  const skillDir = path.join(skillsRoot, skillId);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) return null;

  const files = collectFiles(skillDir).map((filePath) => buildBundleFile(skillDir, filePath));
  const updatedAt = files.length > 0
    ? files.map((file) => new Date(file.updatedAt).getTime()).reduce((max, value) => Math.max(max, value), 0)
    : Date.now();

  return {
    id: skillId,
    formatVersion: 1,
    rootDir: `skills/${skillId}`,
    fileCount: files.length,
    bundleSha256: calculateBundleSha(files),
    updatedAt: new Date(updatedAt).toISOString(),
    manifest: buildManifest(files),
    files,
  };
}
