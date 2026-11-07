import { lazy } from "react";

const AIVisionSettings = lazy(() => import("./pages/AIVisionSettings"));

const routes = {
  "/facility/:facilityId/users/:user/ai-vision": () => <AIVisionSettings />,
};

export default routes;
