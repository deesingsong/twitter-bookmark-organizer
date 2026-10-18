import { ImportPanel } from "@/app/import-panel";
import { BookmarkLibrary } from "@/app/bookmark-library";

export default function Home() {
  return (
    <main className="shell">
      <header className="masthead">
        <span className="mark" aria-hidden="true">B</span>
        <span>BOOKMARK LIBRARY</span>
      </header>
      <section className="intro library-intro" aria-labelledby="welcome-title">
        <p className="eyebrow">YOUR PERSONAL ARCHIVE</p>
        <h1 id="welcome-title">A quieter place for the things worth keeping.</h1>
        <p className="lede">Browse, annotate, and revisit the posts you chose to keep.</p>
      </section>
      <BookmarkLibrary />
      <ImportPanel />
      <footer>Private by design · One owner · Your archive stays yours</footer>
    </main>
  );
}
