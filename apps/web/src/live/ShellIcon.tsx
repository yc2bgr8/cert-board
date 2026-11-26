const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'm20 20-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  inbox: 'M4 4h16v16H4zM4 13h5l2 3h2l2-3h5',
  folder: 'M3 6h7l2 2h9v12H3z',
  calendar: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16',
  close: 'm6 6 12 12M6 18 18 6',
  panel: 'M3 4h18v16H3zM9 4v16',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  chat: 'M4 4h16v12H9l-5 4z',
  chevron: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  shield: 'M12 22s7-3.5 7-10V5l-7-3-7 3v7c0 6.5 7 10 7 10Z M9 12l2 2 4-4',
  stop: 'M7 7h10v10H7z',
  file: 'M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h6',
  check: 'm5 12 4 4L19 6',
  clipboard: 'M9 4H6v16h12V4h-3M9 3h6v4H9zM9 13l2 2 4-4',
  wrench: 'M14 4a5 5 0 0 0-6 6l-4 5a2 2 0 0 0 3 3l5-4a5 5 0 0 0 6-6l-3 3-3-3z',
  arrowUp: 'M12 19V5m-6 6 6-6 6 6',
  attachment: 'm9 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m4 7-7 7a2 2 0 0 1-3-3l7-7',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  mail: 'M3 5h18v14H3zm0 1 9 7 9-7',
  sparkle: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
} as const;

export function ShellIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
