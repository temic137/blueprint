import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const computerFont = localFont({
  variable: "--font-computer",
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
      <body className={computerFont.variable}>{children}</body>
    </html>
  );
}
