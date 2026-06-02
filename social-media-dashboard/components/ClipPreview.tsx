"use client"

import { useState, useRef, useEffect } from "react"

export default function ClipPreview({
  src,
  poster,
}: {
  src: string
  poster: string
}) {
  const [open, setOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Safari requires a direct .play() call after the element mounts —
  // the click that opened the modal doesn't propagate as a user gesture
  // to the video element created in the same tick.
  useEffect(() => {
    if (open && videoRef.current) {
      videoRef.current.play().catch(() => {
        // Blocked (e.g. no user gesture yet) — controls still visible, user can click play
      })
    }
  }, [open])

  return (
    <>
      {/* Thumbnail — click to open */}
      <button
        onClick={() => setOpen(true)}
        style={{
          width: "54px",
          height: "96px",
          overflow: "hidden",
          background: "var(--surface)",
          flexShrink: 0,
          marginTop: "2px",
          borderRadius: "4px",
          border: "none",
          padding: 0,
          cursor: "pointer",
          position: "relative",
        }}
        title="Preview clip"
      >
        <img
          src={poster}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.25)",
        }}>
          <div style={{
            width: "20px", height: "20px", borderRadius: "50%",
            background: "rgba(255,255,255,0.9)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{
              width: 0, height: 0,
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
              borderLeft: "8px solid #111",
              marginLeft: "2px",
            }} />
          </div>
        </div>
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "min(340px, 90vw)",
              aspectRatio: "9/16",
              background: "#000",
              borderRadius: "12px",
              overflow: "hidden",
              position: "relative",
            }}
          >
            <video
              ref={videoRef}
              src={src}
              controls
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
            <button
              onClick={() => setOpen(false)}
              style={{
                position: "absolute", top: "10px", right: "10px",
                background: "rgba(0,0,0,0.6)", border: "none",
                color: "#fff", borderRadius: "50%",
                width: "28px", height: "28px",
                fontSize: "16px", cursor: "pointer", lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  )
}
