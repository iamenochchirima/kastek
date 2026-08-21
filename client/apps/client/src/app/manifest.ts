import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KasiTek app",
    short_name: "KasiTek",
    description: "Manage your KasiTek workspace and connected customer channels.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#090B11",
    theme_color: "#090B11",
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
