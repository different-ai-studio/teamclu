import * as React from "react"
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { Spec } from "@json-render/core"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
  }),
}))

import { DynamicUIMessage } from "@/lib/dynamic-ui/DynamicUI"

// A representative spec exercising container (Card), layout (Stack),
// a data-bound Input (useStateBinding) and a Button — the full render path
// that regressed to a white screen under a naive json-render 0.19 bump.
const sampleSpec: Spec = {
  root: "card",
  elements: {
    card: {
      type: "Card",
      props: { title: "登录", description: "请输入账号" },
      children: ["stack"],
    },
    stack: {
      type: "Stack",
      props: { direction: "column", gap: "md" },
      children: ["field", "submit"],
    },
    field: {
      type: "FormField",
      props: { label: "邮箱", name: "email", required: true },
      children: ["email-input"],
    },
    "email-input": {
      type: "Input",
      props: { type: "email", placeholder: "you@example.com", valuePath: "/email" },
    },
    submit: {
      type: "Button",
      props: { label: "提交", variant: "default" },
    },
  },
}

describe("DynamicUIMessage rendering (json-render 0.19)", () => {
  it("mounts a Spec and renders catalog components without crashing", () => {
    render(<DynamicUIMessage tree={sampleSpec} />)

    expect(screen.getByText("登录")).toBeInTheDocument()
    expect(screen.getByText("请输入账号")).toBeInTheDocument()
    expect(screen.getByText("邮箱")).toBeInTheDocument()
    expect(screen.getByText("提交")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument()
  })

  it("supports two-way state binding on the Input (useStateBinding)", () => {
    render(<DynamicUIMessage tree={sampleSpec} />)

    const input = screen.getByPlaceholderText("you@example.com") as HTMLInputElement
    fireEvent.change(input, { target: { value: "a@b.com" } })
    expect(input.value).toBe("a@b.com")
  })

  it("renders nothing for a null tree when not loading", () => {
    const { container } = render(<DynamicUIMessage tree={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
