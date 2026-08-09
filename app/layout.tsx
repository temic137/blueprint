import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const interfaceFont = localFont({
  variable: "--font-interface",
  display: "swap",
  src: [
    { path: "./fonts/IBMPlexSans-Regular.ttf", weight: "400" },
    { path: "./fonts/IBMPlexSans-Medium.ttf", weight: "500" },
    { path: "./fonts/IBMPlexSans-SemiBold.ttf", weight: "600" },
    { path: "./fonts/IBMPlexSans-Bold.ttf", weight: "700" },
  ],
});

const technicalFont = localFont({
  variable: "--font-technical",
  display: "swap",
  src: [
    { path: "./fonts/IBMPlexMono-Regular.ttf", weight: "400" },
    { path: "./fonts/IBMPlexMono-Medium.ttf", weight: "500" },
    { path: "./fonts/IBMPlexMono-SemiBold.ttf", weight: "600" },
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
