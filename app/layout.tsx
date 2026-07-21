import type { Metadata } from "next";
import { headers } from "next/headers";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from "./lib/site-metadata";
import GlobalAnnouncement from "./components/GlobalAnnouncement";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", base).toString();
  return {
    metadataBase: base,
    title: { default: SITE_TITLE, template: "%s" },
    description: SITE_DESCRIPTION,
    icons: { icon: "/logo.png" },
    openGraph: { siteName: SITE_NAME, title: SITE_TITLE, description: SITE_DESCRIPTION, images: [socialImage], locale: "ko_KR", type: "website" },
    twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION, images: [socialImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}<GlobalAnnouncement /></body></html>;
}
