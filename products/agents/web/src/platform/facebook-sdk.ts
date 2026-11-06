export type FacebookSdk = {
  init(options: Record<string, unknown>): void;
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}

let sdkReady: Promise<FacebookSdk> | undefined;

export async function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (!window.FB) {
    sdkReady ??= new Promise<FacebookSdk>((resolve, reject) => {
      const existing = document.getElementById("agents-facebook-sdk");
      const script = (existing as HTMLScriptElement | null) ?? document.createElement("script");
      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error("Facebook signup could not load. Try again."));
      }, 15000);
      script.addEventListener("load", () => {
        clearTimeout(timeout);
        if (window.FB) resolve(window.FB);
        else reject(new Error("Facebook signup is unavailable."));
      }, { once: true });
      script.addEventListener("error", () => {
        clearTimeout(timeout);
        sdkReady = undefined;
        script.remove();
        reject(new Error("Facebook signup could not load. Try again."));
      }, { once: true });
      if (!existing) {
        script.id = "agents-facebook-sdk";
        script.async = true;
        script.src = "https://connect.facebook.net/en_US/sdk.js";
        document.head.append(script);
      }
    }).catch(error => {
      sdkReady = undefined;
      throw error;
    });
    window.FB = await sdkReady;
  }
  window.FB.init({ appId, version, xfbml: false });
  return window.FB;
}
