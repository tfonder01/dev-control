export default function Loading() {
  return (
    <div className="app-shell">
      <main className="page-container loading-shell" aria-label="Scanning workspace">
        <div className="skeleton skeleton-brand" />
        <div className="skeleton skeleton-heading" />
        <div className="skeleton skeleton-copy" />
        <div className="skeleton-stats">{Array.from({ length: 3 }, (_, index) => <div className="skeleton skeleton-stat" key={index} />)}</div>
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
      </main>
    </div>
  );
}
