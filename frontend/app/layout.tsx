import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet — AI Automated Money Movement",
  description:
    "A digital AI-powered money movement platform for voice-first payments, requests, split transfers, savings goals, and everyday financial control.",
  applicationName: "Wallet",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
