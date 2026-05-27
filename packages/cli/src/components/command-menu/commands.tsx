import type { Command } from "./types";

export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
  },
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
  },
  {
    name: "session",
    description: "Browse past sessions",
    value: "/sessions",
  },
  {
    name: "theme",
    description: "Set a new theme",
    value: "/themes",
  },
  {
    name: "login",
    description: "Sign in with your browser",
    value: "/login",
  },
  {
    name: "logout",
    description: "Sign out of your account",
    value: "/signout",
  },
  {
    name: "upgradde",
    description: "Buy more credits",
    value: "/upgrade",
  },
  {
    name: "useage",
    description: "Open billing portal in your browser",
    value: "/usage",
  },
  {
    name: "exit",
    description: "Quit the application",
    value: "/exit",
    action: (ctx) => {
      ctx.exit();
    },
  },
];
