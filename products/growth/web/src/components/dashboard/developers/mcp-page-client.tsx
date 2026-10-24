"use client";

import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";

export function McpPageClient() {
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>MCP</PageHeaderTitle></PageHeaderContent></PageHeader>
        <Card>
          <CardContent className="space-y-4 p-5">
            <h2 className="text-base font-semibold">MCP unavailable</h2>
            <p className="text-sm text-muted-foreground">Use the REST API with a Developer API key.</p>
            <Button asChild variant="outline"><Link to="/developers/api">View API</Link></Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
