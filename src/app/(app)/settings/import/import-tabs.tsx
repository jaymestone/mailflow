"use client";

import { useState } from "react";
import { FileImportPanel } from "./file-import-panel";
import { QuickAddPanel } from "./quick-add-panel";

export function ImportTabs({
  lists,
  campaigns,
}: {
  lists: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
}) {
  const [tab, setTab] = useState<"file" | "quick">("file");

  return (
    <div>
      <div className="flex gap-2 text-xs">
        <TabButton active={tab === "file"} onClick={() => setTab("file")}>
          Upload CSV/XLSX
        </TabButton>
        <TabButton active={tab === "quick"} onClick={() => setTab("quick")}>
          Paste &amp; enrich
        </TabButton>
      </div>

      <div className="mt-5">
        {tab === "file" ? <FileImportPanel /> : <QuickAddPanel lists={lists} campaigns={campaigns} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 ${
        active ? "border-ink bg-ink text-surface" : "border-hairline-strong text-muted-3"
      }`}
    >
      {children}
    </button>
  );
}
