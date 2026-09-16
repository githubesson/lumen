/* @refresh reload */
import { render } from "solid-js/web";
import "./styles/index.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("landing: #root is missing from index.html");

render(() => <App />, root);
