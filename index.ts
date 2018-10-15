import express from "express";

import {Sender} from "./link";

// prettier-ignore
export type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH";

// prettier-ignore
export type Status = 100 | 101 | 102 | 103 | 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226 | 300 | 301 | 302 | 303 | 304 | 305 |  306 | 307 | 308 | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409 | 410 | 411 | 412 | 413 | 414 | 415 | 416 | 417 | 418 | 421 |  422 | 423 | 424 | 426 | 428 | 429 | 431 | 451 | 500 | 501 | 502 | 503 | 504 | 505 | 506 | 507 | 508 | 510 | 511;

// Config object influences the behavior of both the
// request making and handling logic. It is designed to
// make it possible to represent an arbitrary endpoint
// that is not necessarily managed by this package.
export interface Config {
    // HTTP method used when handling and making requests.
    // Defaults to "POST" if not configured.
    method?: Method;

    // The base should contain everything in the url before
    // the path. Default value of "" will send requests to the
    // same domain.
    base?: string;

    // URL path at which the handler will be registered and
    // the requests will be sent. This setting is required.
    path: string;

    // Expected returned status code(s). By default, anything
    // but a "200" is considered an error. This value is only
    // used for making requests and has no influence on the
    // handler which will also return "200" by default.
    expect?: Status | Status[];
}

// Headers passed when invoking an endpoint.
export interface Headers {
    [name: string]: string;
}

// A stricter version of the Config which demands defined values.
export interface StrictConfig {
    method: Method;
    base: string;
    path: string;
    expect: Status[];
}

// Request handlers contain the server code that transforms
// typed requests into typed responses. Both express' request
// and response objects are passed to the function to make it
// possible to implement custom behavior like accessing and
// writing headers when necessary.
export interface RequestHandler<RQ, RS> {
    (data: RQ, req: express.Request, res: express.Response): Promise<RS> | RS;
}

// An endpoint contains its configuration as well as the types
// of the request and response values.
export class Endpoint<RQ, RS> {
    private static sender: Sender = async (request) => {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            credentials: "same-origin",
        });

        const body = await response.text();
        const status = response.status as Status;
        return {body, status};
    };

    private config: StrictConfig;

    constructor(pathOrConfig: Config | string) {
        // After this block, the input argument can only have
        // the type of a Config.
        if (typeof pathOrConfig === "string") {
            pathOrConfig = {path: pathOrConfig};
        }

        this.config = {
            path: pathOrConfig.path,
            base: pathOrConfig.base || "",
            method: pathOrConfig.method || "POST",
            // The expected status is normalized into an array.
            expect: [].concat(pathOrConfig.expect || (200 as any)) as Status[],
        };
    }

    // The call function sends requests to the configured
    // endpoint using the configured sender function.
    // It returns a promise which may throw errors if there
    // is an issue with the request process or if the status
    // is unexpected.
    public async call(data: RQ, ...h: Headers[]): Promise<RS> {
        const url = `${this.config.base}${this.config.path}`;
        const body = JSON.stringify(data);
        const method = this.config.method;
        const headers: Headers = Object.assign(
            {
                "Content-Type": "application/json",
            },
            ...h,
        );

        const res = await Endpoint.sender({method, url, body, headers});
        if ((this.config.expect as any).indexOf(res.status as any) < 0) {
            let message = res.body;
            if (message.length > 64) {
                message = message.substr(0, 64) + "...";
            }
            throw new Error(`Unexpected status: ${res.status} ${message}`);
        }

        return JSON.parse(res.body);
    }

    // Handler generator returning an express request handler
    // from a config and a request handling function.
    public handler(handler: RequestHandler<RQ, RS>): express.RequestHandler {
        return async (req, res, next) => {
            // Only requests with the correct path and method are handled.
            if (req.path !== this.config.path) {
                return next();
            }
            if (req.method !== this.config.method) {
                return next();
            }

            // Handler is not invoked if a different handler
            // has already answered the request. This situation
            // is considered an error since the handler should
            // have been used.
            if (res.headersSent) {
                return next(new Error("Response has already been sent."));
            }

            // Request body is streamed into a string to be parsed.
            const rawRequestData = await new Promise<string>((resolve) => {
                let data = "";
                req.setEncoding("utf8");
                req.on("data", (chunk) => (data += chunk));
                req.on("end", () => resolve(data));
            });

            let rawResponseData: string = "";
            try {
                const requestData = JSON.parse(rawRequestData);
                const responseData = await handler(requestData, req, res);
                rawResponseData = JSON.stringify(responseData);
            } catch (e) {
                // Handler and serialization errors are forwarded
                // to express to be handled gracefully.
                return next(e);
            }

            // Although the handler is given access to the express
            // response object, it should not send the data itself.
            if (res.headersSent) {
                return next(new Error("Response was sent by handler."));
            }

            res.status(200);
            res.set("Content-Type", "application/json");
            res.send(rawResponseData);
        };
    }
}
