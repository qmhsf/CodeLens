/**
 * 图标组件
 * ------------------------------------------------------------------
 * 统一使用 24×24 线性图标（stroke=currentColor），不依赖图标库，
 * 保证离线可用、体积小、风格一致。
 */
import type { CSSProperties, ReactNode, SVGProps } from 'react';

export type IconName =
  | 'logo'
  | 'code'
  | 'tree'
  | 'explain'
  | 'relation'
  | 'ai'
  | 'notes'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'file'
  | 'upload'
  | 'play'
  | 'pause'
  | 'stepForward'
  | 'stepBack'
  | 'reset'
  | 'close'
  | 'chevronRight'
  | 'chevronDown'
  | 'chevronLeft'
  | 'search'
  | 'copy'
  | 'download'
  | 'check'
  | 'warning'
  | 'error'
  | 'info'
  | 'help'
  | 'sparkles'
  | 'branch'
  | 'loop'
  | 'function'
  | 'variable'
  | 'struct'
  | 'comment'
  | 'memory'
  | 'layers'
  | 'external'
  | 'globe'
  | 'terminal'
  | 'book'
  | 'panelLeft'
  | 'panelRight'
  | 'panelBottom'
  | 'refresh'
  | 'eye'
  | 'eyeOff'
  | 'trash'
  | 'plus'
  | 'arrowRight'
  | 'checkCircle'
  | 'empty';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}

const PATHS: Record<IconName, ReactNode> = {
  logo: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h4.2l2 2H19a1 1 0 0 1 1 1v9.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" opacity=".35" />
      <path d="M8 10.5 6 12.5l2 2M12 10.5l2 2-2 2M15.5 9.5l-2 6" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />,
  tree: <path d="M4 5h6M4 12h9M4 19h5M16 5h4M19 12h2M15 19h5M10 5v7M13 12v7" />,
  explain: <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM8 8h6M8 12h6M8 16h3" />,
  relation: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M8.2 6h7.6M7 8l4 8M17 8l-4 8" />
    </>
  ),
  ai: (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      <circle cx="12" cy="12" r="3.6" />
    </>
  ),
  notes: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.4 2.4-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-3.4v-.2a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.4-2.4.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-3.4h.2a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.4-2.4.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h3.4v.2a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.4 2.4-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v3.4h-.2a1.7 1.7 0 0 0-1.6 1z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
  file: <path d="M6 2h8l5 5v15H6zM14 2v6h6" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  play: <path d="M7 4.5v15l13-7.5z" />,
  pause: <path d="M8 4h3v16H8zM14 4h3v16h-3z" />,
  stepForward: <path d="M6 5v14l9-7zM18 5v14" />,
  stepBack: <path d="M18 5v14l-9-7zM6 5v14" />,
  reset: <path d="M4 10a8 8 0 1 1 2.3 7M4 4v6h6" />,
  close: <path d="M5 5l14 14M19 5 5 19" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5" />
    </>
  ),
  copy: <path d="M9 9h11v11H9zM5 15H4V4h11v1" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  check: <path d="m4 12 5 5L20 6" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  warning: <path d="M12 3 2.5 20h19zM12 9v5M12 17.5v.5" />,
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 8l8 8M16 8l-8 8" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9a2.8 2.8 0 1 1 4.2 2.4c-.9.5-1.5 1-1.5 2.1M12 17v.5" />
    </>
  ),
  sparkles: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
  branch: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 8.2v7.6M6 13a5 5 0 0 0 5-4V7h4.8" />
    </>
  ),
  loop: <path d="M17 2.5 20.5 6 17 9.5M20 6H8a4 4 0 0 0-4 4M7 21.5 3.5 18 7 14.5M4 18h12a4 4 0 0 0 4-4" />,
  function: <path d="M9 4h6M12 4v16M7 20h10M8.5 9H15M8.5 15H15M8.5 9c0-2.2 1-4 3.5-4M8.5 15c0 2.2 1 4 3.5 4" />,
  variable: <path d="M4 4h5v16H4zM15 4h5v16h-5zM9 12h6" />,
  struct: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9" />,
  comment: <path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5" />,
  memory: (
    <>
      <path d="M5 5h14v14H5zM9 5v14M15 5v14M5 9h14M5 15h14" />
      <path d="M2 8v2M2 14v2M22 8v2M22 14v2" />
    </>
  ),
  layers: <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5" />,
  external: <path d="M14 4h6v6M20 4l-8 8M10 4H5v15h15v-5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z" />
    </>
  ),
  terminal: <path d="m5 7 4 5-4 5M11 17h8" />,
  book: <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2zM19 3v18" />,
  panelLeft: <path d="M3 4h18v16H3zM9 4v16" />,
  panelRight: <path d="M3 4h18v16H3zM15 4v16" />,
  panelBottom: <path d="M3 4h18v16H3zM3 14h18" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5" />,
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: <path d="M4 4l16 16M9.5 9.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2M6.2 6.7C3.6 8.4 2 12 2 12s3.5 6 10 6c1.8 0 3.5-.5 5-1.3M10.5 6.1c.5-.1 1-.1 1.5-.1 6.5 0 10 6 10 6s-1.2 2-3.4 3.6" />,
  trash: <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowRight: <path d="M4 12h16M14 6l6 6-6 6" />,
  empty: <path d="M4 5h16v14H4zM8 9h8M8 13h5" />,
};

export function Icon({ name, size = 18, className, style, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name] ?? PATHS.empty}
    </svg>
  );
}

export const CATEGORY_ICONS: Record<string, IconName> = {
  type: 'variable',
  data: 'variable',
  control: 'branch',
  function: 'function',
  operator: 'code',
  pointer: 'memory',
  comment: 'comment',
  preprocessor: 'terminal',
  punctuation: 'code',
};

/** 结构树图标映射 */
export function structureIcon(kind: string): IconName {
  if (kind.includes('function')) return 'function';
  if (kind.includes('call')) return 'function';
  if (kind.includes('if') || kind.includes('condition') || kind.includes('switch') || kind.includes('case') || kind.includes('branch')) return 'branch';
  if (kind.includes('for') || kind.includes('while') || kind.includes('loop') || kind.includes('repeat')) return 'loop';
  if (kind.includes('variable') || kind.includes('declaration') || kind.includes('parameter')) return 'variable';
  if (kind.includes('struct') || kind.includes('typedef') || kind.includes('enum') || kind.includes('class')) return 'struct';
  if (kind.includes('comment')) return 'comment';
  if (kind.includes('preprocessor') || kind.includes('import')) return 'terminal';
  if (kind.includes('block') || kind.includes('body')) return 'layers';
  if (kind.includes('return') || kind.includes('assign') || kind.includes('update') || kind.includes('expression')) return 'code';
  if (kind === 'program') return 'tree';
  return 'code';
}
