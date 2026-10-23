import LegacyLogin from "./legacy-login";
import {buttonClassName} from "@/components/ui/button";
export default function LoginPage(){
 if(!process.env.OPS_BACKEND_URL)return <LegacyLogin/>;
 return <div className="rounded-lg border border-border bg-card p-8 text-center"><h1 className="text-2xl font-semibold text-foreground">KasiTek Labs</h1><a href="/api/operations-auth/login" className={buttonClassName({className:"mt-6 w-full"})}>Sign in</a></div>;
}
