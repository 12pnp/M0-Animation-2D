import "./ui/style.css";
import { mountApp } from "./ui/app";
import { litScrollbars } from "./ui/scrollbars";

const root = document.getElementById("app");
if (root) mountApp(root);
litScrollbars();
