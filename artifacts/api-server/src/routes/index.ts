import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import r2Router from "./r2";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatRouter);
router.use(r2Router);

export default router;
