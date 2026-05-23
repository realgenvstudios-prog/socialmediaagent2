"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function AutoRefresh({ intervalSeconds = 60 }: { intervalSeconds?: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalSeconds * 1000)
    return () => clearInterval(id)
  }, [router, intervalSeconds])

  return null
}
