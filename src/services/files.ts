/**
 * 本地文件导入与语言识别辅助
 * 支持拖拽 / 文件选择上传 .c、.cpp、.h、.py、.js、.ts 等代码文件。
 */
import type { LanguageId } from '../core/analysisTypes';
import { detectLanguage } from '../core/analyze';

/** 支持上传的代码文件扩展名 */
export const SUPPORTED_FILE_EXTENSIONS = [
  '.c',
  '.h',
  '.cpp',
  '.cxx',
  '.cc',
  '.hpp',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.pseudo',
  '.txt',
];

export const MAX_FILE_SIZE = 512 * 1024; // 512KB，避免一次性分析过大文件导致卡顿

export interface ImportedFile {
  fileName: string;
  code: string;
  language: LanguageId;
  detectionReason: string;
  warnings: string[];
}

/** 判断扩展名是否受支持 */
export function isSupportedFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** 读取本地文件为文本 */
export function readTextFile(file: File): Promise<ImportedFile> {
  return new Promise((resolve, reject) => {
    if (!isSupportedFile(file.name)) {
      reject(new Error(`不支持的文件类型：${file.name}。支持 ${SUPPORTED_FILE_EXTENSIONS.join('、')} 等代码文件。`));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error(`文件过大（${(file.size / 1024).toFixed(0)}KB）。请上传小于 ${MAX_FILE_SIZE / 1024}KB 的代码文件。`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (!text.trim()) {
        reject(new Error(`文件内容为空：${file.name}`));
        return;
      }
      const detection = detectLanguage(text, file.name);
      const warnings: string[] = [];
      if (detection.language === 'plaintext') {
        warnings.push('未能从文件内容识别出明确语言，已按纯文本进行有限分析，可手动切换语言。');
      }
      resolve({
        fileName: file.name,
        code: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        language: detection.language,
        detectionReason: detection.reason,
        warnings,
      });
    };
    reader.readAsText(file, 'utf-8');
  });
}

/** 触发浏览器下载文本文件 */
export function downloadTextFile(fileName: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
