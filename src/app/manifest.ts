import type { MetadataRoute } from "next";

// Web app manifest so the CRM can be installed to a phone's home screen
// (Android Chrome "Add to Home screen", iOS Safari "Add to Home Screen").
// Next.js serves this at /manifest.webmanifest and links it in <head>.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fanstate CRM",
    short_name: "Fanstate",
    description: "Fanstate internal WhatsApp CRM.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0b0c",
    theme_color: "#0b0b0c",
    icons: [
      { src: "/favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/favicon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/favicon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
