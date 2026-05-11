import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cited — by Bread & Law",
  description:
    "Assess whether a news outlet is accessible to major AI platforms for training, real-time retrieval, and AI-powered search.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-screen flex flex-col bg-black text-gray-100">
        {children}
      </body>
    </html>
  );
}
