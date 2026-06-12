import { zValidator } from "@hono/zod-validator";
import { db, MessageStatus } from "@nightcode/database";
import { Mode, Role } from "@nightcode/database/enums";
import { findSupportedChatModel } from "@nightcode/shared";
import { Hono } from "hono";
import z from "zod";

const createSessionSchema = z.object({
  title: z.string(),
  cwd: z.string().optional(),
  initialMessage: z
    .object({
      role: z.enum(Role),
      content: z.string(),
      mode: z.enum(Mode),
      model: z
        .string()
        .refine(
          (id) => Boolean(findSupportedChatModel(id)),
          "Unsupported model",
        ),
    })
    .optional(),
});

const createSessionValidator = zValidator(
  "json",
  createSessionSchema,
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }
  },
);

const app = new Hono()

  .get("/", async (c) => {
    const session = await db.session.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        createdAt: true,
      },
    });

    return c.json(session);
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const session = await db.session.findUnique({
      where: {
        id,
      },
      include: {
        messsages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(session);
  })

  .post("/", createSessionValidator, async (c) => {
    const { initialMessage, ...data } = c.req.valid("json");

    const session = await db.session.create({
      data: {
        ...data,
        userId: "mock-user",
        ...(initialMessage && {
          messsages: {
            create: {
              ...initialMessage,
              status: MessageStatus.COMPLETE,
            },
          },
        }),
      },
      include: { messsages: true },
    });

    return c.json(session, 201);
  });

export default app;
