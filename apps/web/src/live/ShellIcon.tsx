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
