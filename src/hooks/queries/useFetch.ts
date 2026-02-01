export async function fetchWithCredentials<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  return response.json();
}

export async function postWithCredentials<T>(url: string, data: unknown): Promise<T> {
  return fetchWithCredentials<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteWithCredentials<T>(url: string): Promise<T> {
  return fetchWithCredentials<T>(url, {
    method: 'DELETE',
  });
}

export async function putWithCredentials<T>(url: string, data: unknown): Promise<T> {
  return fetchWithCredentials<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function patchWithCredentials<T>(url: string, data: unknown): Promise<T> {
  return fetchWithCredentials<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
