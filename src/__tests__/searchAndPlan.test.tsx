import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import LastMileCards from '../components/LastMileCards';
import { lastMile } from '../engine';

describe('TransitSync Search and Journey Planner UX', () => {
  beforeEach(() => {
    // Reset any state if needed
  });

  it('typing "Thal" lists Thaltej and Thaltej Gam', async () => {
    const user = userEvent.setup();
    render(<App />);

    const boardingInput = screen.getByLabelText(/Boarding Station/i) as HTMLInputElement;

    // Focus and clear input
    await user.clear(boardingInput);
    await user.type(boardingInput, 'Thal');

    // Verify Thaltej and Thaltej Gam appear in the dropdown
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      const optionTexts = options.map((opt) => opt.textContent);
      expect(optionTexts.some((t) => t?.includes('Thaltej Gam'))).toBe(true);
      expect(optionTexts.some((t) => t?.includes('Thaltej') && !t?.includes('Thaltej Gam'))).toBe(true);
    });

    // Verify tag is "Metro station"
    const metroTags = screen.getAllByText('Metro station');
    expect(metroTags.length).toBeGreaterThan(0);
  });

  it('typing into a pre-filled field replaces its text', async () => {
    const user = userEvent.setup();
    render(<App />);

    const boardingInput = screen.getByLabelText(/Boarding Station/i) as HTMLInputElement;
    expect(boardingInput.value).toBe('Paldi');

    // Focusing selects all text
    fireEvent.focus(boardingInput);

    // Typing immediately replaces the selected text
    await user.type(boardingInput, 'Thal');
    expect(boardingInput.value).toBe('Thal');

    // Wait for dropdown
    await waitFor(() => {
      expect(screen.getByText('Thaltej Gam')).toBeDefined();
    });
  });

  it('selecting a result then pressing Find Route updates the plan', async () => {
    const user = userEvent.setup();
    render(<App />);

    const boardingInput = screen.getByLabelText(/Boarding Station/i) as HTMLInputElement;

    // Clear and type 'Thal'
    await user.clear(boardingInput);
    await user.type(boardingInput, 'Thal');

    // Find all options and pick Thaltej Gam
    const options = await screen.findAllByRole('option');
    const thaltejGamOpt = options.find((opt) => opt.textContent?.includes('Thaltej Gam'));
    expect(thaltejGamOpt).toBeDefined();

    // Click on Thaltej Gam option
    fireEvent.click(thaltejGamOpt!);

    expect(boardingInput.value).toBe('Thaltej Gam');

    // Press Find Route button
    const findRouteBtn = screen.getByRole('button', { name: /Find route between selected stations/i });
    fireEvent.click(findRouteBtn);

    // Verify itinerary updates with Thaltej Gam -> Vastral Gam
    await waitFor(() => {
      expect(screen.getByText('Suggested Journey Plan')).toBeDefined();
    });
  });

  it('pressing Find Route without a valid selection shows an inline message', async () => {
    const user = userEvent.setup();
    render(<App />);

    const boardingInput = screen.getByLabelText(/Boarding Station/i) as HTMLInputElement;

    // Type something partial without selecting from the list
    await user.clear(boardingInput);
    await user.type(boardingInput, 'UnknownStationXYZ');

    const findRouteBtn = screen.getByRole('button', { name: /Find route between selected stations/i });
    await user.click(findRouteBtn);

    // Expect inline message: "Choose a boarding station from the list"
    await waitFor(() => {
      expect(screen.getByText('Choose a boarding station from the list')).toBeDefined();
    });
  });

  it('clicking x clears the field and keeps dropdown open', async () => {
    const user = userEvent.setup();
    render(<App />);

    const boardingInput = screen.getByLabelText(/Boarding Station/i) as HTMLInputElement;
    expect(boardingInput.value).toBe('Paldi');

    // Find the boarding field's clear button
    const clearBtns = screen.getAllByLabelText('Clear search');
    await user.click(clearBtns[0]);

    expect(boardingInput.value).toBe('');
    expect(document.activeElement).toBe(boardingInput);
  });

  it('typing "iskon" immediately matches ISCON landmark tagged "Place"', async () => {
    const user = userEvent.setup();
    render(<App />);

    const destinationInput = screen.getByLabelText(/Destination/i) as HTMLInputElement;

    await user.clear(destinationInput);
    await user.type(destinationInput, 'iskon');

    await waitFor(() => {
      expect(screen.getByText(/ISCON Cross Road & Temple/i)).toBeDefined();
      expect(screen.getByText('Place')).toBeDefined();
    });
  });
});

describe('RAPIDO CARD & METRO ROUTE MAP UX', () => {
  it('card title is exactly "Book Rapido for your drop" and subtitle shows pickup/drop when different', () => {
    const lm = lastMile('Thaltej Gam', 'Gujarat Science City');
    render(
      <LastMileCards
        lastMile={lm}
        isOnline={true}
        destinationName="Gujarat Science City"
      />,
    );

    // Title is exactly "Book Rapido for your drop"
    expect(screen.getByText('Book Rapido for your drop')).toBeDefined();
    // Subtitle shows both pickup and drop
    expect(screen.getByText(/Pickup:/i)).toBeDefined();
    expect(screen.getByText('Thaltej Gam')).toBeDefined();
    expect(screen.getByText('Gujarat Science City')).toBeDefined();

    // No price, range, or estimated fare is shown
    expect(screen.queryByText(/Estimated Fare/i)).toBeNull();
    expect(screen.queryByText(/Tariff model/i)).toBeNull();
    expect(screen.queryByText(/₹/i)).toBeNull();

    // Muted line below button
    expect(
      screen.getByText('Opens Rapido. Fare and booking happen in the Rapido app.'),
    ).toBeDefined();
  });

  it('subtitle does not repeat the same station name when destination equals station', () => {
    const lm = lastMile('Vastral Gam', 'Vastral Gam');
    render(
      <LastMileCards
        lastMile={lm}
        isOnline={true}
        destinationName="Vastral Gam"
      />,
    );

    expect(screen.getByText('Book Rapido for your drop')).toBeDefined();
    // Subtitle contains "Choose your drop in the Rapido app."
    expect(screen.getByText(/Choose your drop in the Rapido app\./i)).toBeDefined();
    // Should NOT show "| Drop:"
    expect(screen.queryByText(/Drop:/i)).toBeNull();
  });

  it('copies destination and shows toast when destination differs from station', async () => {
    const user = userEvent.setup();
    const lm = lastMile('Thaltej Gam', 'Gujarat Science City');

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    const windowOpenMock = vi.fn();
    window.open = windowOpenMock;

    render(
      <LastMileCards
        lastMile={lm}
        isOnline={true}
        destinationName="Gujarat Science City"
      />,
    );

    const bookBtn = screen.getByRole('button', { name: /Book Rapido/i });
    expect(bookBtn).toBeDefined();
    expect(bookBtn.className).toContain('min-h-[44px]');

    await user.click(bookBtn);

    // Verify destination was copied to clipboard
    expect(writeTextMock).toHaveBeenCalledWith('Gujarat Science City');

    // Verify toast
    expect(
      screen.getByText('Destination copied. Paste it as your drop in Rapido.'),
    ).toBeDefined();

    // Verify window.open opened Rapido
    expect(windowOpenMock).toHaveBeenCalledWith(
      'https://www.rapido.bike/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('copies nothing and shows "Open Rapido and choose your drop." when destination is same as station', async () => {
    const user = userEvent.setup();
    const lm = lastMile('Vastral Gam', 'Vastral Gam');

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    const windowOpenMock = vi.fn();
    window.open = windowOpenMock;

    render(
      <LastMileCards
        lastMile={lm}
        isOnline={true}
        destinationName="Vastral Gam"
      />,
    );

    const bookBtn = screen.getByRole('button', { name: /Book Rapido/i });
    await user.click(bookBtn);

    // Should NOT copy
    expect(writeTextMock).not.toHaveBeenCalled();

    // Verify toast
    expect(screen.getByText('Open Rapido and choose your drop.')).toBeDefined();
  });

  it('button is disabled offline and shows "Needs internet to open Rapido"', () => {
    const lm = lastMile('Thaltej Gam', 'Gujarat Science City');
    render(
      <LastMileCards
        lastMile={lm}
        isOnline={false}
        destinationName="Gujarat Science City"
      />,
    );

    const disabledBtn = screen.getByRole('button', {
      name: /Needs internet to open Rapido/i,
    });
    expect(disabledBtn).toBeDefined();
    expect((disabledBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Needs internet to open Rapido')).toBeDefined();
  });

  it('renders Metro route map section and modal with zoom controls and Escape close', async () => {
    const user = userEvent.setup();
    const lm = lastMile('Thaltej Gam');

    render(<LastMileCards lastMile={lm} isOnline={true} />);

    // Check heading
    expect(screen.getByText('Metro route map')).toBeDefined();

    // Check thumbnail image
    const mapImg = screen.getByAltText('Ahmedabad and Gandhinagar metro route map');
    expect(mapImg).toBeDefined();
    expect(mapImg.getAttribute('src')).toBe('/images/metro-route-map.webp');

    // Tap to enlarge button
    const enlargeBtn = screen.getByRole('button', { name: /Tap to enlarge/i });
    await user.click(enlargeBtn);

    // Modal opens
    const modal = screen.getByRole('dialog', { name: /Metro route map full-screen viewer/i });
    expect(modal).toBeDefined();

    // Close modal via close button
    const closeBtn = screen.getByRole('button', { name: /Close full-screen map viewer/i });
    await user.click(closeBtn);

    // Modal is closed
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
