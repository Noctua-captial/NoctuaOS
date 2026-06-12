import type { Metadata } from "next";
import { Geist, Cormorant_Garamond, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { CommandBar } from "@/components/command-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Noctua OS",
  description: "Private intelligence terminal. Sees in the dark.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${cormorant.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="noctua-watermark min-h-full">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="relative z-10 flex-1 overflow-x-hidden">{children}</main>
        </div>
        <CommandBar />
      </body>
    </html>
  );
}
