//! Drawing on the screen, away from any OS: the pixels (`raster`), the strokes
//! (`canvas`) and the bar with colours and tools (`bar`). Each OS backend only
//! shows the picture in a window over the screen and passes the pointer on.

pub mod bar;
pub mod canvas;
pub mod raster;
