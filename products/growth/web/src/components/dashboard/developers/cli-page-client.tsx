import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { useDevelopersData } from "./developers-data";

export function CliPageClient() {
  const { config } = useDevelopersData();

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>CLI</PageHeaderTitle><PageHeaderDescription>Terminal setup.</PageHeaderDescription></PageHeaderContent></PageHeader>
        <MotionReveal>
          <Card><CardContent className="space-y-4 p-5"><div><h2 className="text-base font-semibold">REST from the terminal</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Use a Developer API key stored in an environment variable or secret manager.</p></div><pre className="overflow-x-auto rounded-lg bg-secondary/50 p-4 text-xs leading-6 text-foreground">{`export KASITEK_API_KEY="<developer-api-key>"\ncurl ${config.restBaseUrl}/capabilities \\\n  -H "Authorization: Bearer $KASITEK_API_KEY"`}</pre><Button asChild variant="outline"><Link to="/developers/api-keys">Create an API key <ExternalLink className="ml-2 h-3.5 w-3.5" /></Link></Button></CardContent></Card>
        </MotionReveal>
      </div>
    </div>
  );
}
