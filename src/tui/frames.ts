/**
 * Ralph Wiggum ASCII art frames and quotes.
 */

export const RALPH_FRAMES = [
  // Frame 0: Normal — eyes open
  [
    "       \\│╱       ",
    "     ╭─────╮     ",
    "     │ ° ° │     ",
    "     │  ▷  │     ",
    "     │ ╰─╯ │     ",
    "     ╰──┬──╯     ",
    "    ╭───┴───╮    ",
    "    │       │    ",
    "    ╰───┬───╯    ",
    "      ╱   ╲      ",
    "     ╱     ╲     ",
  ],
  // Frame 1: Blinking
  [
    "       \\│╱       ",
    "     ╭─────╮     ",
    "     │ - - │     ",
    "     │  ▷  │     ",
    "     │ ╰─╯ │     ",
    "     ╰──┬──╯     ",
    "    ╭───┴───╮    ",
    "    │       │    ",
    "    ╰───┬───╯    ",
    "      ╱   ╲      ",
    "     ╱     ╲     ",
  ],
  // Frame 2: Happy
  [
    "       \\│╱       ",
    "     ╭─────╮     ",
    "     │ ^ ^ │     ",
    "     │  ▷  │     ",
    "     │ ╰▽╯ │     ",
    "     ╰──┬──╯     ",
    "    ╭───┴───╮    ",
    "    │       │    ",
    "    ╰───┬───╯    ",
    "      ╱   ╲      ",
    "     ╱     ╲     ",
  ],
  // Frame 3: Thinking (look up)
  [
    "     ? \\│╱       ",
    "     ╭─────╮     ",
    "     │ ◦ ◦ │     ",
    "     │  ▷  │     ",
    "     │  ─  │     ",
    "     ╰──┬──╯     ",
    "    ╭───┴───╮    ",
    "    │       │    ",
    "    ╰───┬───╯    ",
    "      ╱   ╲      ",
    "     ╱     ╲     ",
  ],
];

export const RALPH_QUOTES = [
  '"I\'m helping!"',
  '"Me fail English? That\'s unpossible!"',
  '"I bent my wookie."',
  '"My cat\'s breath smells like cat food."',
  '"I\'m learnding!"',
  '"The doctor said I wouldn\'t have so many nosebleeds if I kept my finger outta there."',
  '"When I grow up, I\'m going to Bovine University!"',
  '"Hi, Super Nintendo Chalmers!"',
  '"That\'s where I saw the leprechaun. He tells me to burn things."',
  '"I found a moonrock in my nose!"',
  '"Go banana!"',
  '"My worm went in my mouth and then I ate it."',
  '"Mrs. Krabappel and Principal Skinner were in the closet making babies."',
  '"I picked a red one!"',
  '"Even my boogers are spicy!"',
  '"Bushes are nice cause they don\'t have prickers. Unless they do. This one did. Ouch."',
];

export const PHASE_LABELS: Record<string, string> = {
  spec: "Spec",
  build: "Build",
  build_verify: "Verify (build)",
  full_verify: "Verify (full)",
  audit: "Audit",
  pr: "Ship PR",
};

export const PHASE_ORDER = [
  "spec",
  "build",
  "build_verify",
  "full_verify",
  "audit",
  "pr",
];
