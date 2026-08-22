//! Reusable RDP protocol core for Dolgate.
//!
//! The desktop sidecar and native mobile FFI both use these modules. Decoded framebuffer bytes
//! remain inside Rust/native code; callers provide an [`output::OutputSink`] when they do not use
//! the sidecar framing transport.

mod audio;
mod audio_input;
mod audio_output_dvc;
mod camera;
mod camera_pdu;
mod clipboard;
mod drive;
mod egfx;
mod egfx_surface;

pub mod ffi;
pub mod output;
pub mod protocol;
pub mod runtime;
pub mod session;
