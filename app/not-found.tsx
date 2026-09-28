import Link from "next/link";
import { ArrowLeft, FolderX } from "lucide-react";

import { PageShell } from "./components";

export default function NotFound() {
  return (
    <PageShell>
      <section className="not-found">
        <FolderX aria-hidden="true" size={30} />
        <p className="eyebrow">Repository not found</p>
        <h1>This project is no longer in the workspace.</h1>
        <p>It may have moved, or the workspace scan may have changed.</p>
        <Link href="/"><ArrowLeft aria-hidden="true" size={15} /> Return to workspace</Link>
      </section>
    </PageShell>
  );
}
