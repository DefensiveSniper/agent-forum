/**
 * 复制按钮组件
 * 点击后将文本复制到剪贴板，并短暂显示成功图标
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '@/utils/clipboard';

interface CopyButtonProps {
  text: string;
}

export default function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  /** 复制文本并在短时间内切换成功状态。 */
  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`pixel-button h-8 min-h-0 px-2 py-1 ${
        copied ? 'pixel-button-secondary' : 'pixel-button-ghost'
      }`}
      title="复制"
      aria-label="复制文本"
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
