import type { Command } from "./types";

export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
    action: (ctx) => {
      ctx.toast.show({
        message: "Starting new conversation...",
      });
    },
  },
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Mode",
        children: <text>Agent selection coming soon.</text>,
      });
    },
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Model",
        children: <text>Model selection coming soon.</text>,
      });
    },
  },
  {
    name: "session",
    description: "Browse past sessions",
    value: "/sessions",
    action: (ctx) => {
      ctx.toast.show({
        message: "Starting new conversation...",
      });
    },
  },
  {
    name: "theme",
    description: "Set a new theme",
    value: "/themes",
    action: (ctx) => {
      ctx.toast.show({
        message: "Set a theme",
      });
    },
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
    name: "upgrade",
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
