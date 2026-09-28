// Importing icons used for navigation in the header
import monitorPlay from "../assets/images/icons/monitorPlay.png";
import monitorPlayWhite from "../assets/images/icons/monitorPlayWhite.png";
import detective from "../assets/images/icons/detective.png";
import detectiveWhite from "../assets/images/icons/detectiveWhite.png";
import insight from "../assets/images/icons/insight.png";
import insightWhite from "../assets/images/icons/insightwhite.png";

// Type definition for each page item
export interface PageItem {
  icon: string;
  iconWhite: string;
  height: string;
  width: string;
  name: string;
  active: boolean;
  pageUrl: string;
  // When set, this nav entry only renders once useFeatureFlags()[featureFlag]
  // is true — see Header.tsx's navigation filtering.
  featureFlag?: string;
}

// List of pages for the header navigation
export const pages: PageItem[] = [
  {
    icon: monitorPlay,
    iconWhite: monitorPlayWhite,
    height: "20px",
    width: "20px",
    name: "Monitor",
    active: false,
    pageUrl: "/monitor",
  },
  {
    icon: detective,
    iconWhite: detectiveWhite,
    height: "25px",
    width: "25px",
    name: "Investigation",
    active: false,
    pageUrl: "/investigation",
  },
  {
    icon: insight,
    iconWhite: insightWhite,
    height: "20px",
    width: "20px",
    name: "Insights",
    active: false,
    pageUrl: "/insights",
  },
  {
    // Reuses the Insights icon — no dedicated jewelry-dashboard asset exists yet.
    icon: insight,
    iconWhite: insightWhite,
    height: "20px",
    width: "20px",
    name: "Jewelry Dashboard",
    active: false,
    pageUrl: "/jewelry-dashboard",
    featureFlag: "JEWELRY_DETECTION",
  },
];
