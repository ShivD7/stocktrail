/** Presentation only: retain the timestamp's absolute value and show the viewer's timezone. */
export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}
