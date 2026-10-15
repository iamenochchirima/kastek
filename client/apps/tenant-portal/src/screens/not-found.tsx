import Link from "@/lib/link";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold tracking-widest text-primary">
          404
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          This page may have moved, or the link may be incorrect.
        </p>
        <Button asChild className="mt-6">
          <Link href="/">Return home</Link>
        </Button>
      </div>
    </main>
  );
}
