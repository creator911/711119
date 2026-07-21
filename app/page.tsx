import type { Metadata } from "next";
import Portal from "./components/Portal";

export const metadata: Metadata = {
  title: "검증된 출장 서비스",
  description: "지역별 검증 업체와 실시간 후기, 커뮤니티를 한곳에서 확인하세요.",
};

export default function Home() {
  return <Portal />;
}
