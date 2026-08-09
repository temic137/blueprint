import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const interfaceFont = localFont({
  variable: "--font-interface",
  display: "swap",
  src: [
    { path: "./fonts/Geist-Regular.ttf", weight: "400" },
    { path: "./fonts/Geist-Medium.ttf", weight: "500" },
    { path: "./fonts/Geist-SemiBold.ttf", weight: "600" },
    { path: "./fonts/Geist-Bold.ttf", weight: "700" },
  ],
});

const technicalFont = localFont({
  variable: "--font-technical",
  display: "swap",
  src: [
    { path: "./fonts/GeistMono-Regular.ttf", weight: "400" },
    { path: "./fonts/GeistMono-Medium.ttf", weight: "500" },
    { path: "./fonts/GeistMono-SemiBold.ttf", weight: "600" },
  ],
});

export const metadata: Metadata = {
  title: "Blueprint — AI Engineering Drawings",
  description: "Turn an idea into a buildable circuit — board, parts, wiring, and assembly instructions.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${interfaceFont.variable} ${technicalFont.variable}`}>{children}</body>
    </html>
  );
}
