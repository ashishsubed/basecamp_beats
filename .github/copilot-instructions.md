# Basecamp Beats - AI Agent Instructions

This document provides essential knowledge for AI agents working with the Basecamp Beats codebase.

## Project Overview
Basecamp Beats is a web platform for promoting Nepali cultural events, music, and community networking. The project currently uses a simple static website approach with HTML and embedded CSS.

## Architecture and Structure
- Single-page application in `index.html`
- Embedded CSS for styling (located in the `<style>` section of `index.html`)
- Static assets:
  - `/logo.webp` - Main logo image
  - `/event-poster.webp` - Event promotional image

## Design Patterns and Conventions
1. **Color Scheme**:
   - Primary accent: `#FFD166` (golden yellow)
   - Background gradient: `#1B0F3B` to `#000814` (dark purple to navy)
   - Card background: `#121029` (dark purple)
   - Text colors: White (`#fff`) for headers, `#ccc` for regular text

2. **Component Structure**:
   - `header` - Logo, title, and slogan
   - `hero` - Featured event section with poster and CTA
   - `cards` - Three-column feature highlights
   - `footer` - Copyright and social media info

3. **Responsive Design**:
   - Mobile-first approach
   - Breakpoint at 700px for desktop layout
   - Cards stack vertically on mobile, horizontal on desktop

## Integration Points
- Event ticket sales integrate with xudustore.com platform
- Current event link: `https://www.xudustore.com/event-details-registration/nepali-junction`

## Developer Workflow
1. **Asset Requirements**:
   - Images should be in WebP format for optimal performance
   - Logo dimensions: 150px width (maintainable aspect ratio)
   - Event poster should maintain 16:9 aspect ratio

2. **Styling Guidelines**:
   - Use the established color palette for consistency
   - Maintain responsive breakpoints at 700px
   - Keep card sections balanced with equal width distribution

## Known Patterns
- CTA buttons use golden yellow background (`#FFD166`) with black text
- Cards use 1px golden yellow border for visual distinction
- Gradient backgrounds for depth and visual interest

For any questions or clarifications, please ask for feedback on specific sections.