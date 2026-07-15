import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import NavLink from "@/components/NavLink"
import LogoutButton from "@/components/LogoutButton"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Content Studio · Afropolitan",
  description: "Social media automation dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{
            maxWidth: "1000px",
            margin: "0 auto",
            padding: "0 2rem",
            height: "54px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            {/* Brand */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{
                display: "inline-block",
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: "var(--green)",
                boxShadow: "0 0 0 2.5px rgba(22,163,74,0.18)",
              }} />
              <span style={{ fontSize: "13px", fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text)" }}>
                Afropolitan
              </span>
              <span style={{
                fontSize: "11px",
                color: "var(--muted)",
                padding: "2px 9px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "100px",
                letterSpacing: "0.01em",
              }}>
                Content Studio
              </span>
            </div>

            {/* Nav */}
            <nav style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              <NavLink href="/">Overview</NavLink>
              <NavLink href="/queue">Clips</NavLink>
              <NavLink href="/performance">Performance</NavLink>
              <NavLink href="/social">Social</NavLink>
              <NavLink href="/intelligence">Intelligence</NavLink>
              <NavLink href="/process">Process</NavLink>
              <LogoutButton />
            </nav>
          </div>
        </header>

        <main style={{ maxWidth: "1000px", margin: "0 auto", padding: "3.5rem 2rem 5rem" }}>
          {children}
        </main>
      </body>
    </html>
  )
}
