import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", base).toString();
  return {
    metadataBase: base,
    title: { default: "출장나라", template: "%s | 출장나라" },
    description: "검증된 출장 서비스와 실제 후기를 한곳에서 확인하세요.",
    icons: { icon: "/logo.png" },
    openGraph: { title: "출장나라", description: "검증된 출장 서비스를 한곳에서.", images: [socialImage], locale: "ko_KR", type: "website" },
    twitter: { card: "summary_large_image", title: "출장나라", description: "검증된 출장 서비스를 한곳에서.", images: [socialImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
