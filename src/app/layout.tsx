import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuctionBoss",
  description: "법원경매 물건 수집·열람·AI 분석 서비스",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
