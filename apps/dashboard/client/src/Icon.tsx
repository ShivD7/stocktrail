const paths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  issues: 'M12 3 2 21h20L12 3z M12 9v5 M12 17h.01',
  products: 'm12 3 9 5v8l-9 5-9-5V8l9-5z M3 8l9 5 9-5 M12 13v8 M7.5 5.5l9 5',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  trail: 'M5 5h8a4 4 0 0 1 0 8h-2a3 3 0 0 0 0 6h8 M5 2v6 M19 16v6',
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
