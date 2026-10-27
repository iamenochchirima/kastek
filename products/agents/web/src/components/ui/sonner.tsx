import { useEffect, useState } from "react";
import { Toaster as SharedToaster } from "@kasitek-labs/ui/sonner";
import type { ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <SharedToaster position={mobile ? "top-center" : "bottom-right"} {...props} />;
}
