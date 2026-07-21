import type { Metadata } from "next";
import Portal from "./components/Portal";
import { SITE_DESCRIPTION, SITE_TITLE } from "./lib/site-metadata";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
};

export default function Home() {
  return <Portal />;
}
