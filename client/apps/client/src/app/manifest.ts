import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KasiTek",
    short_name: "KasiTek",
    description:
      "AI agents, automation systems, and digital infrastructure for businesses.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#17191c",
    theme_color: "#17191c",
    orientation: "portrait",
    icons: [
      {
        src: "/facebook-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
      },
      {
        src: "/facebook-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
      },
      {
        src: "/facebook-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/facebook-app-icon-dark-1024.png",
        sizes: "1024x1024",
        type: "image/png",
      },
    ],
  };
}
