import { FileScan } from "lucide-react";
import { lazy } from "react";

import routes from "./routes";

const manifest = {
  plugin: "care_ai_vision_fe",
  routes,
  extends: [],
  components: {
    PatientRegistrationForm: lazy(() => import("./components/OCRFormFill")),
    DiagnosticReportOverride: lazy(
      () => import("./components/DiagnosticReportOCR"),
    ),
  },
  userNavItems: [
    {
      url: "ai-vision",
      name: "AI Vision",
      icon: <FileScan />,
    },
  ],
  devices: [],
} as const;

export default manifest;
