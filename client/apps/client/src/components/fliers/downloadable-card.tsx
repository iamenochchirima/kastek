"use client";

import { useRef, useState } from "react";
import { toPng } from "html-to-image";

export default function DownloadableCard({
  children,
  filename,
}: {
  children: React.ReactNode;
  filename: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!cardRef.current) return;
    setDownloading(true);

    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        cacheBust: true,
      });

      const link = document.createElement("a");
      link.download = `${filename}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div ref={cardRef}>{children}</div>
      <button
        onClick={handleDownload}
        disabled={downloading}
        className="bg-white/10 hover:bg-white/20 text-white px-6 py-2.5 rounded-full text-sm font-semibold transition-all disabled:opacity-50"
      >
        {downloading ? "Generating..." : "Download as PNG"}
      </button>
    </div>
  );
}
