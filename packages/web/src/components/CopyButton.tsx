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
      className="inline-flex items-center p-1 text-gray-500 hover:text-gray-700 transition-colors"
      title="复制"
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
