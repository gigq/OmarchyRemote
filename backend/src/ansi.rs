//! vt100 0.15 implements CUP (CSI H) but not the equivalent HVP (CSI f),
//! which btop uses for absolute cursor positioning. Normalize only parser input;
//! clients still receive the unmodified stream. State spans PTY read boundaries.
#[derive(Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Csi(bool),
    Charset(usize),
    String,
    StringEscape,
}
#[derive(Default)]
pub struct CursorAliases {
    state: State,
    query: usize,
    graphics: [bool; 2],
    active: usize,
    saved: ([bool; 2], usize),
}
impl CursorAliases {
    // Answer cursor queries even before a browser connects. TUIs such as dua
    // ask during startup and otherwise time out before a screen can be shown.
    pub fn process(&mut self, parser: &mut vt100::Parser, input: &[u8]) -> Vec<u8> {
        let mut replies = Vec::new();
        for byte in input {
            let in_string = matches!(self.state, State::String | State::StringEscape);
            if !in_string && *byte == b"\x1b[6n"[self.query] {
                self.query += 1;
            } else {
                self.query = if !in_string && *byte == 0x1b { 1 } else { 0 };
            }
            let graphics = matches!(self.state, State::Ground) && self.graphics[self.active];
            let mut normalized = [*byte];
            self.normalize_in_place(&mut normalized);
            if graphics && (0x60..=0x7e).contains(byte) {
                const CHARS: [char; 31] = [
                    '◆', '▒', '␉', '␌', '␍', '␊', '°', '±', '␤', '␋', '┘', '┐', '┌', '└', '┼', '⎺',
                    '⎻', '─', '⎼', '⎽', '├', '┤', '┴', '┬', '│', '≤', '≥', 'π', '≠', '£', '·',
                ];
                let mut encoded = [0; 4];
                parser.process(
                    CHARS[usize::from(*byte - 0x60)]
                        .encode_utf8(&mut encoded)
                        .as_bytes(),
                );
            } else {
                parser.process(&normalized);
            }
            if self.query == 4 {
                self.query = 0;
                let (row, col) = parser.screen().cursor_position();
                replies.extend(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
            }
        }
        replies
    }
    #[cfg(test)]
    pub fn normalize(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = input.to_vec();
        self.normalize_in_place(&mut output);
        output
    }
    fn normalize_in_place(&mut self, output: &mut [u8]) {
        for byte in output {
            self.state = match self.state {
                State::Ground => {
                    if *byte == 0x0e {
                        self.active = 1;
                    }
                    if *byte == 0x0f {
                        self.active = 0;
                    }
                    if *byte == 0x1b {
                        State::Escape
                    } else {
                        State::Ground
                    }
                }
                State::Escape => match *byte {
                    b'[' => State::Csi(true),
                    b'(' => State::Charset(0),
                    b')' => State::Charset(1),
                    b'7' => {
                        self.saved = (self.graphics, self.active);
                        State::Ground
                    }
                    b'8' => {
                        (self.graphics, self.active) = self.saved;
                        State::Ground
                    }
                    b'c' => {
                        self.graphics = [false; 2];
                        self.active = 0;
                        State::Ground
                    }
                    b']' | b'P' | b'^' | b'_' | b'X' => State::String,
                    0x1b => State::Escape,
                    _ => State::Ground,
                },
                State::Charset(slot) => {
                    self.graphics[slot] = *byte == b'0';
                    State::Ground
                }
                State::Csi(valid) => {
                    if (0x40..=0x7e).contains(byte) {
                        if valid && *byte == b'f' {
                            *byte = b'H'
                        }
                        State::Ground
                    } else if *byte == 0x1b {
                        State::Escape
                    } else {
                        State::Csi(valid && (byte.is_ascii_digit() || *byte == b';'))
                    }
                }
                State::String => match *byte {
                    0x07 => State::Ground,
                    0x1b => State::StringEscape,
                    _ => State::String,
                },
                State::StringEscape => match *byte {
                    b'\\' => State::Ground,
                    0x1b => State::StringEscape,
                    _ => State::String,
                },
            };
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn btop_cursor_positions_survive_every_read_boundary() {
        let bytes = b"\x1b[?1049h\x1b[2J\x1b[1;1fTOP\x1b[3;9fCPU\x1b[6;1fBOTTOM";
        for split in 0..=bytes.len() {
            let mut aliases = CursorAliases::default();
            let mut parser = vt100::Parser::new(10, 30, 0);
            parser.process(&aliases.normalize(&bytes[..split]));
            parser.process(&aliases.normalize(&bytes[split..]));
            assert_eq!(parser.screen().contents(), "TOP\n\n        CPU\n\n\nBOTTOM");
            let mut restored = vt100::Parser::new(10, 30, 0);
            restored.process(&parser.screen().state_formatted());
            assert_eq!(restored.screen().contents(), parser.screen().contents());
        }
    }
    #[test]
    fn dec_borders_restore_as_unicode_instead_of_literal_letters() {
        let mut aliases = CursorAliases::default();
        let mut parser = vt100::Parser::new(10, 40, 0);
        for byte in b"\x1b(0lqqkx\x1b(B text \x1b)0\x0ex\x0f ok" {
            aliases.process(&mut parser, &[*byte]);
        }
        assert_eq!(parser.screen().contents(), "┌──┐│ text │ ok");
        let mut restored = vt100::Parser::new(10, 40, 0);
        restored.process(&parser.screen().state_formatted());
        assert_eq!(restored.screen().contents(), parser.screen().contents());
    }
    #[test]
    fn cursor_query_works_without_client_and_across_chunks() {
        let mut aliases = CursorAliases::default();
        let mut parser = vt100::Parser::new(20, 80, 0);
        let mut replies = Vec::new();
        for byte in b"\x1b[4;9H\x1b[6n\x1b]0;literal \x1b[6n\x07" {
            replies.extend(aliases.process(&mut parser, &[*byte]));
        }
        assert_eq!(replies, b"\x1b[4;9R");
    }
    #[test]
    fn text_strings_and_private_sequences_are_unchanged() {
        let bytes = b"file\x1b]0;literal \x1b[1;2f\x07\x1b[?1f\x1b[38;2;1;2;3m";
        let mut aliases = CursorAliases::default();
        let output: Vec<u8> = bytes
            .iter()
            .flat_map(|b| aliases.normalize(&[*b]))
            .collect();
        assert_eq!(output, bytes);
    }
}
